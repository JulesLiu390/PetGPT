import React, { useEffect, useRef, useState } from 'react';
import { CharacterImage } from '../assets';
import { useStateValue } from '../content/StateProvider';
import { FaRocketchat } from "react-icons/fa";



export const Character = () => {
    const [{characterMood}, dispatch] = useStateValue();


  const [imgSrc, setImgSrc] = useState('../assets/sample-normal.png');
  const handleClick = () => {
    window.electron?.showChatWindow();
  }

  useEffect(() => {
    console.log("Character useEffect triggered with characterMood:", characterMood);
    import(`../assets/sample-${characterMood}.png`)
      .then(module => {
        setImgSrc(module.default);
      })
      .catch(err => {
        console.error('Failed to load image:', err);
      });
  }, [characterMood]);


//   img

  return (
    <div className='h-auto flex flex-col'>
    <div className='flex justify-evenly'>
      <FaRocketchat
      onClick={handleClick}
      ></FaRocketchat>
      <FaRocketchat></FaRocketchat>
      <FaRocketchat></FaRocketchat>
      <FaRocketchat></FaRocketchat>
    </div>

    
    <img 
      src={imgSrc}
      draggable="false"
      alt="character"
      className="cursor-pointer draggable"
    />

</div>
  );
};

export default Character;